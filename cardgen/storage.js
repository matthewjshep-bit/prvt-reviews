// storage.js — rendered-card + provider-cache object storage.
//
// Production: Cloudflare R2 (S3-compatible) behind a public base URL, so MMS
// carrier fetches and iMessage previews never hit a Render dynamic route
// (architecture rule 3). Dev/no-R2: falls back to local disk served by cardgen
// at /files/*, so the whole pipeline still runs end-to-end.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "";
// Public base for stored objects, e.g. https://cards.knownintown.com (no trailing slash).
const R2_PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || "").replace(/\/$/, "");

export const r2Enabled = Boolean(
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_PUBLIC_BASE
);

// Local fallback
const LOCAL_DIR = process.env.CARDGEN_FILES_DIR || path.join(DIR, "files");
const CARDGEN_PUBLIC_URL = (process.env.CARDGEN_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
export const LOCAL_FILES_DIR = LOCAL_DIR;

let s3 = null;
async function client() {
  if (s3) return s3;
  const { S3Client } = await import("@aws-sdk/client-s3");
  s3 = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return s3;
}

export function publicUrlFor(key) {
  return r2Enabled ? `${R2_PUBLIC_BASE}/${key}` : `${CARDGEN_PUBLIC_URL}/files/${key}`;
}

// True if the object already exists (used for deterministic cache hits).
export async function objectExists(key) {
  if (r2Enabled) {
    try {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      await (await client()).send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
  return fs.existsSync(path.join(LOCAL_DIR, key));
}

export async function putObject(key, buffer, contentType) {
  if (r2Enabled) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await client()).send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      })
    );
  } else {
    const dest = path.join(LOCAL_DIR, key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buffer);
  }
  return publicUrlFor(key);
}

export async function getObject(key) {
  if (r2Enabled) {
    try {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const res = await (await client()).send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
      const chunks = [];
      for await (const c of res.Body) chunks.push(c);
      return { buffer: Buffer.concat(chunks), contentType: res.ContentType };
    } catch {
      return null;
    }
  }
  try {
    return { buffer: await fsp.readFile(path.join(LOCAL_DIR, key)), contentType: undefined };
  } catch {
    return null;
  }
}

export async function putJson(key, obj) {
  return putObject(key, Buffer.from(JSON.stringify(obj)), "application/json");
}
export async function getJson(key) {
  const o = await getObject(key);
  if (!o) return null;
  try {
    return JSON.parse(o.buffer.toString("utf8"));
  } catch {
    return null;
  }
}

/* ---------- deterministic cache keys ---------- */

// Stable JSON: sort object keys recursively so equal data → equal string.
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

export function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

// cache key = sha256(templateId + templateVersion + canonical(resolved data)).
export function renderCacheKey({ templateId, templateVersion, resolved, extra }) {
  return sha256(
    `${templateId || "adhoc"}::${templateVersion || 0}::${canonicalize(resolved || {})}::${canonicalize(extra || {})}`
  );
}
