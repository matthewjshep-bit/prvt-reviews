// net.js — SSRF-guarded outbound fetch, shared by the legacy card renderer, the
// new bitmap-layer loader, and every data/image provider (§4 security).
//
// Guarantees for every request:
//   • https:// only (http:// rejected) unless explicitly allowed for a host
//   • DNS-resolve the target and reject private / link-local / loopback IPs
//   • follow at most `maxRedirects` hops, RE-VALIDATING each hop (redirect to a
//     private IP is blocked)
//   • hard timeout and response-size cap
//   • optional host allowlist + host blocklist (block our own hosts + GHL API)

import dns from "node:dns/promises";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 10_000;

// Hosts providers must never be pointed at (SSRF into our own control plane or
// the GHL API where the PIT lives). Extendable via BLOCKED_FETCH_HOSTS.
const BASE_BLOCKED = [
  "services.leadconnectorhq.com",
  "rest.gohighlevel.com",
  ...String(process.env.BLOCKED_FETCH_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
];

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local + cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::") return true;
    if (l.startsWith("fe80")) return true; // link-local
    if (l.startsWith("fc") || l.startsWith("fd")) return true; // unique-local
    if (l.startsWith("::ffff:")) return isPrivateIp(l.replace("::ffff:", ""));
    return false;
  }
  return true; // unknown family → unsafe
}

// Validate a single URL string against policy. Throws on violation, returns a
// URL object on success. Does NOT follow redirects (caller loops).
export async function assertSafeUrl(raw, { allowedHosts = [], blockedHosts = [], allowHttp = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("bad_url"), { code: "bad_url" });
  }
  if (url.protocol === "http:" && !allowHttp) throw Object.assign(new Error("http_not_allowed"), { code: "scheme" });
  if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error("bad_scheme"), { code: "scheme" });

  const host = url.hostname.toLowerCase();
  const blocked = [...BASE_BLOCKED, ...blockedHosts.map((h) => h.toLowerCase())];
  if (blocked.includes(host)) throw Object.assign(new Error("host_blocked"), { code: "host_blocked" });
  if (allowedHosts.length && !allowedHosts.map((h) => h.toLowerCase()).includes(host))
    throw Object.assign(new Error("host_not_allowed"), { code: "host_not_allowed" });

  // Resolve every A/AAAA record and reject if ANY is private (defends against
  // a hostname that resolves to a mix of public + private addresses).
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw Object.assign(new Error("dns_failed"), { code: "dns" });
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
    throw Object.assign(new Error("private_ip"), { code: "private_ip" });

  return url;
}

// SSRF-safe fetch that returns { buffer, contentType, finalUrl }. Follows
// redirects manually so each hop is re-validated.
export async function safeFetch(raw, opts = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    maxBytes = 10_000_000,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = 3,
    contentTypePrefix, // e.g. "image/" — reject anything else
    allowedHosts,
    blockedHosts,
    allowHttp,
  } = opts;

  let current = raw;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertSafeUrl(current, { allowedHosts, blockedHosts, allowHttp });
      const res = await fetch(current, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: ctrl.signal,
      });

      // Manual redirect handling: re-validate the Location target next loop.
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop === maxRedirects) throw Object.assign(new Error("too_many_redirects"), { code: "redirects" });
        current = new URL(res.headers.get("location"), current).toString();
        continue;
      }

      if (!res.ok) throw Object.assign(new Error(`fetch_status_${res.status}`), { code: "status", status: res.status });

      const ct = res.headers.get("content-type") || "";
      if (contentTypePrefix && !ct.toLowerCase().startsWith(contentTypePrefix))
        throw Object.assign(new Error("bad_content_type"), { code: "content_type", contentType: ct });

      const ab = await res.arrayBuffer();
      if (ab.byteLength > maxBytes) throw Object.assign(new Error("response_too_large"), { code: "too_large" });
      return { buffer: Buffer.from(ab), contentType: ct, finalUrl: current };
    }
    throw Object.assign(new Error("too_many_redirects"), { code: "redirects" });
  } finally {
    clearTimeout(timer);
  }
}

// Convenience: fetch and return JSON (size-capped, SSRF-guarded).
export async function safeFetchJson(raw, opts = {}) {
  const { buffer, finalUrl } = await safeFetch(raw, { maxBytes: 1_000_000, ...opts });
  return { json: JSON.parse(buffer.toString("utf8")), finalUrl };
}
