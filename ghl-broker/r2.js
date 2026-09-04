// r2.js — broker-side Cloudflare R2 uploads for user assets (image layers).
// Falls back to local disk (served at /uploads) when R2 isn't configured, so
// uploads work in dev. NOTE: local URLs are private-host and will be refused by
// cardgen's SSRF guard at render time — production must use R2 (public host).

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "";
const R2_PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || "").replace(/\/$/, "");

// Two switches, because they answer different questions. The raw object store
// (videos, below) needs only credentials and a bucket. Public assets also need
// R2_PUBLIC_BASE — the hostname printed on every document URL — and setting it
// is what moves generated documents out of Postgres. So an operator can turn on
// video with four variables without changing where their PDFs live.
const R2_CREDENTIAL_VARS = { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET };
export const r2Missing = Object.entries(R2_CREDENTIAL_VARS).filter(([, v]) => !v).map(([k]) => k);
export const r2StoreEnabled = r2Missing.length === 0;
export const r2Enabled = r2StoreEnabled && Boolean(R2_PUBLIC_BASE);

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
// fallback location + the URL prefix that maps to it. contentDisposition, when
// set, is stored on the object and served back by R2 (names the Save dialog).
export async function uploadAsset(key, buffer, contentType, { localDir, localBaseUrl, contentDisposition }) {
  if (r2Enabled) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await client()).send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
        ...(contentDisposition ? { ContentDisposition: contentDisposition } : {}),
      })
    );
    return `${R2_PUBLIC_BASE}/${key}`;
  }
  const dest = path.join(localDir, key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buffer);
  return `${localBaseUrl}/${key}`;
}

/* ---------- raw objects: multipart upload, ranged read, delete ----------
 * Same bucket, different contract from uploadAsset: nothing here returns a
 * public URL. These hold property videos, which investors reach only through
 * the broker's token-gated routes (routes/dataroom.js → video.js), so
 * revoking a room revokes its videos too. Without R2 the objects are files
 * under `localDir` — dev and tests only; Render's disk is ephemeral.
 *
 * R2's multipart rules, which the client (messaging-app/src/DataroomModal.jsx)
 * is written to: every part except the last must be the SAME size, and no
 * part but the last may be under 5MB. The local fallback doesn't care, which
 * is why the tests can use a single small part.
 * ---------------------------------------------------------------------- */

// Keys are built server-side from uuids and ids, but the local path still
// refuses anything that could climb out of localDir.
const localPath = (localDir, key) =>
  path.join(localDir, ...String(key).split("/").map((s) => s.replace(/[^A-Za-z0-9._-]/g, "_") || "_"));
const partsDir = (localDir, uploadId) => path.join(localDir, ".multipart", String(uploadId).replace(/[^A-Za-z0-9-]/g, ""));

export async function createMultipart(key, contentType, { localDir }) {
  if (r2StoreEnabled) {
    const { CreateMultipartUploadCommand } = await import("@aws-sdk/client-s3");
    const r = await (await client()).send(new CreateMultipartUploadCommand({
      Bucket: R2_BUCKET, Key: key, ContentType: contentType, CacheControl: "private, max-age=86400",
    }));
    return { uploadId: r.UploadId };
  }
  const uploadId = crypto.randomUUID();
  await fs.mkdir(partsDir(localDir, uploadId), { recursive: true });
  return { uploadId };
}

export async function uploadPart(key, uploadId, partNumber, body, { localDir }) {
  if (r2StoreEnabled) {
    const { UploadPartCommand } = await import("@aws-sdk/client-s3");
    const r = await (await client()).send(new UploadPartCommand({
      Bucket: R2_BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body,
    }));
    return { etag: r.ETag };
  }
  const dir = partsDir(localDir, uploadId);
  await fs.access(dir); // an unknown upload id fails here, as R2 would
  await fs.writeFile(path.join(dir, String(partNumber)), body);
  return { etag: `"${crypto.createHash("md5").update(body).digest("hex")}"` };
}

// `parts` is [{ partNumber, etag }] in ascending order. Answers the size of
// the finished object, which is the one number the upload's own bookkeeping
// can't be trusted for.
export async function completeMultipart(key, uploadId, parts, { localDir }) {
  if (r2StoreEnabled) {
    const { CompleteMultipartUploadCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = await client();
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: R2_BUCKET, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }));
    const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return { size: Number(head.ContentLength) || 0 };
  }
  const dir = partsDir(localDir, uploadId);
  const dest = localPath(localDir, key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, Buffer.alloc(0));
  for (const p of parts) await fs.appendFile(dest, await fs.readFile(path.join(dir, String(p.partNumber))));
  await fs.rm(dir, { recursive: true, force: true });
  return { size: (await fs.stat(dest)).size };
}

export async function abortMultipart(key, uploadId, { localDir }) {
  if (r2StoreEnabled) {
    const { AbortMultipartUploadCommand } = await import("@aws-sdk/client-s3");
    await (await client()).send(new AbortMultipartUploadCommand({ Bucket: R2_BUCKET, Key: key, UploadId: uploadId }));
    return;
  }
  await fs.rm(partsDir(localDir, uploadId), { recursive: true, force: true });
}

export async function deleteObject(key, { localDir }) {
  if (r2StoreEnabled) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await client()).send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return;
  }
  await fs.rm(localPath(localDir, key), { force: true });
}

// A Range header, resolved against the object's size. null means "serve the
// whole thing" — which per the RFC is also the right answer to a header we
// can't parse. { bad: true } is a range that names bytes the object doesn't
// have, which must be a 416 and never a silent full response.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!suffix) return { bad: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!(start < size) || start > end) return { bad: true };
  return { start, end };
}

// Read an object, or a byte range of it. Answers { status, body, contentLength,
// contentRange, contentType }: status 200 with the whole object, 206 with the
// slice, 416 for an unsatisfiable range, 404 for no such key. `body` is a
// Readable to pipe straight into the response — bytes never sit in memory.
export async function readObject(key, { range, localDir }) {
  if (r2StoreEnabled) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      const r = await (await client()).send(new GetObjectCommand({
        Bucket: R2_BUCKET, Key: key, ...(range ? { Range: range } : {}),
      }));
      return {
        status: r.$metadata?.httpStatusCode === 206 ? 206 : 200,
        body: r.Body,
        contentLength: r.ContentLength ?? null,
        contentRange: r.ContentRange || "",
        contentType: r.ContentType || "",
      };
    } catch (err) {
      const code = err?.$metadata?.httpStatusCode;
      if (code === 416 || err?.name === "InvalidRange") return { status: 416, body: null, contentLength: 0, contentRange: "", contentType: "" };
      if (code === 404 || err?.name === "NoSuchKey" || err?.name === "NotFound") return { status: 404, body: null };
      throw err;
    }
  }
  const file = localPath(localDir, key);
  let size;
  try { size = (await fs.stat(file)).size; } catch { return { status: 404, body: null }; }
  const r = parseRange(range, size);
  if (r?.bad) return { status: 416, body: null, contentLength: 0, contentRange: `bytes */${size}`, contentType: "" };
  if (r) {
    return {
      status: 206, body: createReadStream(file, { start: r.start, end: r.end }),
      contentLength: r.end - r.start + 1, contentRange: `bytes ${r.start}-${r.end}/${size}`, contentType: "",
    };
  }
  return { status: 200, body: createReadStream(file), contentLength: size, contentRange: "", contentType: "" };
}
