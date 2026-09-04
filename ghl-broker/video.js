// video.js — property videos: where their bytes live and how they stream.
//
// A phone walkthrough is a few hundred MB, which rules out everything the
// photos do (base64 in a JSON body, bytea in Postgres). The browser sends the
// file in uniform 8MB parts, and each part is stored as an object of its own
// under the video's key — never glued into one file. That is what lets a
// walkthrough live in a bucket whose per-file limit is smaller than the video
// (Supabase's free plan allows 50MB per object), and it needs nothing from the
// store beyond put, head, get-with-range and delete.
//
// Playback stitches the parts back together on the fly. Because every part
// but the last is exactly PART_BYTES, any byte range maps to a run of parts by
// arithmetic — no manifest, no index — and the broker answers with a 206 slice
// or a full 200 with Range support either way. Safari refuses to play a
// <video> from a server that ignores Range, and a scrub bar is a stream of
// small ranged requests.
//
// Without an object store the same calls write files under DATA_DIR, which is
// right for dev and tests and wrong for production: Render's disk is wiped on
// deploy, so Postgres-without-a-bucket refuses uploads (videoStorageReady)
// rather than lose them silently a day later.

import crypto from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbEnabled } from "./db.js";
import { deletePrefix, headObject, parseRange, putObject, readObject, storeEnabled, storeMissing } from "./r2.js";

// Container → what the client may send. Browsers decide what they can PLAY by
// codec, not container, and this can't see codecs: an iPhone's default HEVC
// .mov is a valid upload that some Android phones won't play. The console says so.
export const VIDEO_TYPES = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_VIDEOS_PER_OFFER = 10;
// Uniform parts are the whole trick: the range math in streamVideo depends on
// every part but the last being exactly this size, and finishVideoUpload
// refuses a set that isn't. 8MB keeps a retry cheap on a phone and sits well
// under any bucket's per-object limit. Tests shrink it to exercise the seams.
export const PART_BYTES = Number(process.env.VIDEO_PART_BYTES) || 8 * 1024 * 1024;
export const MAX_PARTS = Math.ceil(MAX_VIDEO_BYTES / PART_BYTES);

// An endpoint, credentials and a bucket are all video needs — not
// R2_PUBLIC_BASE, which is about document URLs and would move the PDFs too.
// The hint names exactly the variables still missing, so the fix is one trip
// to the Render dashboard.
export const videoStorageReady = storeEnabled || !dbEnabled;
export const VIDEO_STORAGE_HINT =
  `Video storage isn't set up on this server — set ${storeMissing.length ? storeMissing.join(", ") : "the S3_* variables"} ` +
  "on the Render service (Supabase Storage → S3 connection; see RUNBOOK.md) to enable video uploads.";

// The local fallback's root. Same default as store.js so a dev checkout keeps
// everything under one data/ folder; keys carry their own videos/ prefix.
export const videoLocalRoot = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const local = { localDir: videoLocalRoot };

// The video's key is a PREFIX; its parts live beneath it as 000001, 000002…
export const videoKey = (locationId, offerId, videoId) => `videos/${locationId}/${offerId}/${videoId}`;
const partKey = (key, n) => `${key}/${String(n).padStart(6, "0")}`;

// The first bytes of an upload have to look like a video, the way photos have
// to look like an image: ISO-BMFF (MP4 and QuickTime) carries "ftyp" at
// offset 4; WebM opens with the EBML magic. Everything else is refused before
// a single part lands in the bucket.
export function sniffVideoType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes.slice(4, 8).toString("ascii") === "ftyp") {
    return bytes.slice(8, 10).toString("ascii") === "qt" ? "video/quicktime" : "video/mp4";
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return null;
}

// Nothing to open remotely: parts are plain objects. The id only names the
// attempt on the row, so an abandoned upload can be told from a finished one.
export async function beginVideoUpload() {
  return { uploadId: crypto.randomUUID() };
}

export const putVideoPart = (key, uploadId, partNumber, body) =>
  putObject(partKey(key, partNumber), body, "application/octet-stream", local);

// Prove every part is there and the run is uniform, and answer the total. A
// short middle part would silently corrupt every range past it, so the whole
// set is refused and removed rather than kept as a video that seeks wrong.
export async function finishVideoUpload(key, uploadId, parts) {
  const sizes = [];
  for (const p of parts) {
    const h = await headObject(partKey(key, p.partNumber), local);
    if (!h) throw Object.assign(new Error(`part ${p.partNumber} of the upload never arrived — try that video again`), { http: 400 });
    sizes.push(h.size);
  }
  const last = sizes[sizes.length - 1];
  const uniform = sizes.length > 0 && sizes.slice(0, -1).every((s) => s === PART_BYTES) && last > 0 && last <= PART_BYTES;
  if (!uniform) {
    await deletePrefix(key, local).catch(() => {});
    throw Object.assign(new Error("the upload's parts weren't the agreed size — try that video again"), { http: 400 });
  }
  return { size: sizes.reduce((t, s) => t + s, 0) };
}

export const abortVideoUpload = (key) => deletePrefix(key, local);
export const deleteVideoObject = (key) => deletePrefix(key, local);

// Wait for the response to take more bytes — or for the viewer to leave.
const drained = (res) => Promise.race([once(res, "drain"), once(res, "close")]);

// Stream one video into an Express response, honoring Range, from its run of
// part objects. `size` is the row's total; with uniform parts that is all the
// arithmetic needs. Returns false if the video isn't there, so the caller can
// answer with its own 404 (the dataroom's is a deliberately uninformative
// notice). Callers set their own cache/robots headers first; this only sets
// what the bytes themselves need.
export async function streamVideo(req, res, { key, contentType, etag, size }) {
  const total = Math.round(Number(size)) || 0;
  if (!total) return false;
  const range = parseRange(req.headers.range, total);
  res.set("Accept-Ranges", "bytes");
  res.set("Content-Type", contentType || "video/mp4");
  if (etag) res.set("ETag", etag);
  if (range?.bad) {
    res.set("Content-Range", `bytes */${total}`);
    res.status(416).end();
    return true;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  const first = Math.floor(start / PART_BYTES);
  const last = Math.floor(end / PART_BYTES);

  // Open the first part before committing to a status: a video whose objects
  // are gone should be a 404, not a 206 that dies.
  const slice = (p) => {
    const base = p * PART_BYTES;
    return `bytes=${Math.max(start, base) - base}-${Math.min(end, base + PART_BYTES - 1) - base}`;
  };
  let obj = await readObject(partKey(key, first + 1), { range: slice(first), localDir: videoLocalRoot });
  if (obj.status === 404 || !obj.body) return false;

  res.set("Content-Length", String(end - start + 1));
  if (range) res.set("Content-Range", `bytes ${start}-${end}/${total}`);
  res.status(range ? 206 : 200);
  if (req.method === "HEAD") {
    if (typeof obj.body.destroy === "function") obj.body.destroy();
    res.end();
    return true;
  }

  // A viewer who scrubs away mid-slice closes the response; stop reading from
  // the bucket the moment they do rather than draining the rest for nobody.
  let gone = false;
  res.on("close", () => { gone = true; });
  try {
    for (let p = first; p <= last && !gone; p++) {
      if (p !== first) {
        obj = await readObject(partKey(key, p + 1), { range: slice(p), localDir: videoLocalRoot });
        if (obj.status === 404 || !obj.body) throw new Error(`video part ${p + 1} missing under ${key}`);
      }
      for await (const chunk of obj.body) {
        if (gone) break;
        if (!res.write(chunk)) await drained(res);
      }
      if (gone && typeof obj.body.destroy === "function") obj.body.destroy();
    }
    if (!gone) res.end();
  } catch (err) {
    console.error("video stream failed:", err.message);
    res.destroy();
  }
  return true;
}
