// render.js — personalized review-card image renderer
// Pure logic, no server. Exported so it can be unit-tested or reused.

import sharp from "sharp";
import dns from "node:dns/promises";
import net from "node:net";

const FONT_STACK =
  "'DejaVu Sans','Liberation Sans','Arial','Helvetica',sans-serif";

// Optional allowlist of background-image hosts (comma separated in env).
// STRONGLY recommended in production — set it to your storage bucket domain.
const ALLOWED_BG_HOSTS = (process.env.ALLOWED_BG_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const FETCH_TIMEOUT_MS = 5000;
const MAX_BG_BYTES = 10_000_000; // 10 MB ceiling on the source image

// ---------- input hygiene ----------

export function sanitizeName(raw, { excite = true } = {}) {
  let s = String(raw ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "") // strip control chars
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 40) s = s.slice(0, 40).trim();
  if (!s) s = "there";
  if (excite && !/[!?.…]$/.test(s)) s = s + "!";
  return s;
}

function xmlEscape(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- SSRF guard ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local + cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
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
  return true; // unknown family → treat as unsafe
}

async function assertSafeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("bad_bg_url");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("bg_scheme");
  if (ALLOWED_BG_HOSTS.length && !ALLOWED_BG_HOSTS.includes(url.hostname.toLowerCase()))
    throw new Error("bg_host_not_allowed");
  // Resolve and reject private targets. (Note: not fully rebinding-proof —
  // the host allowlist above is the strong control.)
  const { address } = await dns.lookup(url.hostname);
  if (isPrivateIp(address)) throw new Error("bg_private_ip");
  return url.toString();
}

async function fetchImage(rawUrl) {
  const safe = await assertSafeUrl(rawUrl);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(safe, { signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error("bg_fetch_status_" + res.status);
  const ct = res.headers.get("content-type") || "";
  if (!ct.startsWith("image/")) throw new Error("bg_not_image");
  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_BG_BYTES) throw new Error("bg_too_large");
  return Buffer.from(ab);
}

// ---------- overlay ----------

function buildOverlaySvg({ w, h, name, brand, demo }) {
  const padX = Math.round(w * 0.05);
  const maxPill = Math.round(w * 0.86);
  let font = Math.round(h * 0.085);
  const estWidth = (fs) => name.length * fs * 0.6; // rough bold-sans metric
  if (estWidth(font) + padX * 2 > maxPill) {
    font = Math.max(18, Math.floor((maxPill - padX * 2) / (name.length * 0.6)));
  }
  const pillW = Math.min(maxPill, Math.round(estWidth(font) + padX * 2));
  const pillH = Math.round(font * 1.75);
  const pillX = Math.round((w - pillW) / 2);
  const pillY = Math.round(h * 0.63);
  const cx = Math.round(w / 2);
  const textY = Math.round(pillY + pillH / 2);
  const rx = Math.round(pillH / 2);

  const brandSvg = brand
    ? `<text x="${cx}" y="${Math.round(h * 0.17)}" text-anchor="middle" ` +
      `dominant-baseline="central" font-family="${FONT_STACK}" font-weight="bold" ` +
      `font-size="${Math.round(h * 0.075)}" fill="#ffffff" letter-spacing="3">${xmlEscape(
        brand
      )}</text>`
    : "";

  // Demo mode: a dashed placeholder box in the logo area with muted
  // "YOUR LOGO HERE" text. Marketing "try it out" funnel only.
  let demoSvg = "";
  if (demo) {
    const boxW = Math.round(w * 0.6);
    const boxH = Math.round(h * 0.18);
    const boxX = Math.round((w - boxW) / 2);
    const boxY = Math.round(h * 0.2);
    const boxRx = Math.round(Math.min(boxW, boxH) * 0.12);
    const dash = Math.round(w * 0.018);
    const demoFont = Math.round(h * 0.05);
    const demoTextY = Math.round(boxY + boxH / 2);
    demoSvg =
      `<rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="${boxRx}" ry="${boxRx}" ` +
      `fill="none" stroke="#9aa0a6" stroke-width="4" stroke-dasharray="${dash} ${dash}"/>` +
      `<text x="${cx}" y="${demoTextY}" text-anchor="middle" dominant-baseline="central" ` +
      `font-family="${FONT_STACK}" font-weight="bold" font-size="${demoFont}" ` +
      `fill="#c4c7cc" letter-spacing="4">YOUR LOGO HERE</text>`;
  }

  return Buffer.from(
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.45"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${Math.round(h * 0.42)}" width="${w}" height="${Math.round(
      h * 0.58
    )}" fill="url(#scrim)"/>
  ${brandSvg}
  ${demoSvg}
  <rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="${rx}" ry="${rx}" fill="#ffffff"/>
  <text x="${cx}" y="${textY}" text-anchor="middle" dominant-baseline="central" font-family="${FONT_STACK}" font-weight="bold" font-size="${font}" fill="#0b0b0c">${xmlEscape(
      name
    )}</text>
</svg>`
  );
}

// ---------- main entry ----------

export async function renderCard({
  name,
  bg,
  brand,
  w = 1080,
  h = 1080,
  format = "jpeg",
  excite = true,
  demo = false,
} = {}) {
  w = Math.min(2000, Math.max(300, parseInt(w, 10) || 1080));
  h = Math.min(2000, Math.max(300, parseInt(h, 10) || 1080));
  const safeName = sanitizeName(name, { excite });

  let base;
  if (bg && !demo) {
    const buf = await fetchImage(bg);
    base = sharp(buf).resize(w, h, { fit: "cover", position: "centre" });
  } else {
    base = sharp({
      create: { width: w, height: h, channels: 3, background: "#0b0b0c" },
    });
  }

  const overlay = buildOverlaySvg({ w, h, name: safeName, brand, demo });
  let pipe = base.composite([{ input: overlay, top: 0, left: 0 }]);

  if (format === "png") {
    return { buffer: await pipe.png({ compressionLevel: 9 }).toBuffer(), contentType: "image/png" };
  }
  return {
    buffer: await pipe.jpeg({ quality: 82, mozjpeg: true }).toBuffer(),
    contentType: "image/jpeg",
  };
}
