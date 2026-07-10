// r2.js — broker-side Cloudflare R2 uploads for user assets (image layers).
// Falls back to local disk (served at /uploads) when R2 isn't configured, so
// uploads work in dev. NOTE: local URLs are private-host and will be refused by
// cardgen's SSRF guard at render time — production must use R2 (public host).

import fs from "node:fs/promises";
import path from "node:path";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "";
const R2_PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || "").replace(/\/$/, "");

export const r2Enabled = Boolean(
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_PUBLIC_BASE
);

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

// Upload bytes and return a public URL. localDir/localBaseUrl are the dev
// fallback location + the URL prefix that maps to it.
export async function uploadAsset(key, buffer, contentType, { localDir, localBaseUrl }) {
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
    return `${R2_PUBLIC_BASE}/${key}`;
  }
  const dest = path.join(localDir, key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buffer);
  return `${localBaseUrl}/${key}`;
}
