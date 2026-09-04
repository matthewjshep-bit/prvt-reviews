// video.js — property videos: where their bytes live and how they stream.
//
// A phone walkthrough is a few hundred MB, which rules out everything the
// photos do (base64 in a JSON body, bytea in Postgres). Bytes go to R2 in
// parts as the browser sends them (r2.js), the row in the store carries the
// key, and playback streams back through the token-gated dataroom routes with
// Range support — Safari refuses to play a <video> at all from a server that
// ignores Range, and a scrub bar is a stream of small ranged requests.
//
// Without R2 the same calls write files under DATA_DIR, which is right for
// dev and tests and wrong for production: Render's disk is wiped on deploy, so
// Postgres-without-R2 refuses uploads (videoStorageReady) rather than lose
// them silently a day later.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbEnabled } from "./db.js";
import {
  abortMultipart, completeMultipart, createMultipart, deleteObject, r2Enabled, readObject, uploadPart,
} from "./r2.js";

// Container → file extension. Browsers decide what they can PLAY by codec, not
// container, and this can't see codecs: an iPhone's default HEVC .mov is a
// valid upload that some Android phones won't play. The console says so.
export const VIDEO_TYPES = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_VIDEOS_PER_OFFER = 10;
// Uniform parts: R2 insists every part but the last be the same size, and no
// part but the last be under 5MB. 8MB keeps a retry cheap on a phone.
export const PART_BYTES = 8 * 1024 * 1024;
export const MAX_PARTS = Math.ceil(MAX_VIDEO_BYTES / PART_BYTES);

export const videoStorageReady = r2Enabled || !dbEnabled;
export const VIDEO_STORAGE_HINT =
  "Video storage isn't set up on this server — add the R2_* variables (see RUNBOOK.md) to enable video uploads.";

// The local fallback's root. Same default as store.js so a dev checkout keeps
// everything under one data/ folder; keys carry their own videos/ prefix.
export const videoLocalRoot = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const local = { localDir: videoLocalRoot };

export const videoKey = (locationId, offerId, videoId, contentType) =>
  `videos/${locationId}/${offerId}/${videoId}.${VIDEO_TYPES[contentType] || "bin"}`;

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

export const beginVideoUpload = (key, contentType) => createMultipart(key, contentType, local);
export const putVideoPart = (key, uploadId, partNumber, body) => uploadPart(key, uploadId, partNumber, body, local);
export const finishVideoUpload = (key, uploadId, parts) => completeMultipart(key, uploadId, parts, local);
export const abortVideoUpload = (key, uploadId) => abortMultipart(key, uploadId, local);
export const deleteVideoObject = (key) => deleteObject(key, local);

// Stream one video into an Express response, honoring Range. Returns false if
// the object isn't there, so the caller can answer with its own 404 (the
// dataroom's is a deliberately uninformative notice). Callers set their own
// cache/robots headers first; this only sets what the bytes themselves need.
export async function streamVideo(req, res, { key, contentType, etag }) {
  const obj = await readObject(key, { range: req.headers.range, localDir: videoLocalRoot });
  if (obj.status === 404) return false;
  res.set("Accept-Ranges", "bytes");
  res.set("Content-Type", contentType || obj.contentType || "video/mp4");
  if (etag) res.set("ETag", etag);
  if (obj.status === 416) {
    if (obj.contentRange) res.set("Content-Range", obj.contentRange);
    res.status(416).end();
    return true;
  }
  if (obj.contentLength != null) res.set("Content-Length", String(obj.contentLength));
  if (obj.status === 206) res.set("Content-Range", obj.contentRange);
  res.status(obj.status);
  if (req.method === "HEAD" || !obj.body) {
    res.end();
    return true;
  }
  // A viewer who scrubs away mid-slice closes the response; stop reading from
  // the bucket the moment they do rather than draining the rest for nobody.
  obj.body.on("error", () => res.destroy());
  res.on("close", () => { if (typeof obj.body.destroy === "function") obj.body.destroy(); });
  obj.body.pipe(res);
  return true;
}
