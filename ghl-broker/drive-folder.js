// drive-folder.js — turn a Google Drive link into image URLs the photo
// importer can already swallow.
//
// The problem this solves: the operator's deal photos live in a Drive folder,
// and pasting that folder's URL into the photo box fails — a folder URL
// returns HTML, and fetch-image.js verifies bytes by magic number, so it
// (correctly) rejects it as "not a direct image". Pasting 30 per-file links
// instead is nobody's idea of a workflow.
//
// Two pieces, deliberately separate:
//
//   1. LISTING a folder needs the Drive API, and the Drive API needs a
//      credential. Because a shared deal folder is "anyone with the link",
//      a plain API key is enough — no OAuth, no consent screen, no refresh
//      tokens. That key stays on the server.
//   2. DOWNLOADING a file needs no credential at all: if we could list the
//      folder, it is link-shared, and its files are fetchable anonymously.
//
// So this module hands the client ordinary image URLs and the client feeds
// them through /photos/from-url one at a time — the same path a dragged image
// takes. One fetch path, one set of SSRF guards, one place that decides sizes.
//
// WHY THE THUMBNAIL ENDPOINT for images rather than the raw file: Drive's
// /thumbnail always re-encodes to JPEG, which means an iPhone HEIC in the
// folder arrives as something the byte sniffer recognises AND a browser canvas
// can decode. It also caps resolution server-side (returning the original when
// it is smaller), so a 6MB phone photo doesn't cross the wire only to be
// downscaled to 1600px in image.js anyway, and it never hits the virus-scan
// interstitial that /uc serves for large files. PDFs are the exception — a
// thumbnail of a PDF is a picture of page one — so exhibits ask for `original`.

const DRIVE_API_BASE = (process.env.DRIVE_API_BASE_URL || "https://www.googleapis.com/drive/v3").replace(/\/$/, "");
const DRIVE_FILE_BASE = (process.env.DRIVE_FILE_BASE_URL || "https://drive.google.com").replace(/\/$/, "");

// Ceiling on one folder import. Each file is its own round trip through the
// browser's downscaler, so this is a patience limit rather than a technical
// one; a deal folder that genuinely holds more than this wants curating first.
export const DRIVE_MAX_FILES = 100;

// Long edge to ask Drive for. Comfortably above the 1600px `full` variant in
// messaging-app/src/image.js, so the browser is always downscaling rather than
// upscaling, with headroom if that number ever grows.
const THUMB_PX = 2400;

// Drive ids are URL-safe base64-ish. Anchored and character-limited because
// the folder id is interpolated into the API's `q` expression below — no
// quote can survive this, so the query can't be broken out of.
const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;

const bad = (message, http = 400) => Object.assign(new Error(message), { http });

const isDriveHost = (host) => host === "drive.google.com" || host === "www.drive.google.com";

function parse(raw) {
  try {
    return new URL(String(raw || "").trim());
  } catch {
    return null;
  }
}

/**
 * Folder id out of any shape of Drive folder link, or "" if it isn't one.
 *   /drive/folders/<id>            /drive/u/0/folders/<id>
 *   /drive/u/0/mobile/folders/<id> …all with any ?usp= tail
 */
export function parseDriveFolderId(rawUrl) {
  const u = parse(rawUrl);
  if (!u || !isDriveHost(u.hostname)) return "";
  const m = /\/folders\/([^/?#]+)/.exec(u.pathname);
  const id = m ? decodeURIComponent(m[1]) : "";
  return DRIVE_ID.test(id) ? id : "";
}

/**
 * File id out of a single-file Drive link, or "" if it isn't one.
 *   /file/d/<id>/view    /open?id=<id>    /uc?id=<id>
 */
export function parseDriveFileId(rawUrl) {
  const u = parse(rawUrl);
  if (!u || !isDriveHost(u.hostname)) return "";
  const m = /\/file\/d\/([^/?#]+)/.exec(u.pathname);
  const id = m ? decodeURIComponent(m[1]) : (u.searchParams.get("id") || "");
  return DRIVE_ID.test(id) ? id : "";
}

/** A Drive file id → a URL that answers with the image bytes themselves. */
export const driveImageUrl = (fileId, px = THUMB_PX) =>
  `${DRIVE_FILE_BASE}/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${px}`;

/** A Drive file id → a URL that answers with the file's own bytes, unconverted. */
export const driveOriginalUrl = (fileId) =>
  `${DRIVE_FILE_BASE}/uc?export=download&id=${encodeURIComponent(fileId)}`;

/**
 * Rewrite a single-file Drive share link into something fetch-image.js can
 * accept, and pass everything else through untouched. Called at the fetch call
 * sites rather than inside fetch-image.js so that module stays purely about
 * the SSRF guards — and the rewritten URL is still a public drive.google.com
 * address, so it runs the full gauntlet like any other.
 *
 * `original` asks for the file's real bytes instead of a JPEG rendering, which
 * is what a PDF exhibit needs.
 */
export function driveDirectUrl(rawUrl, { original = false } = {}) {
  const raw = String(rawUrl || "").trim();
  // /uc and /thumbnail already return bytes — rewriting them would only
  // second-guess an operator who pasted the working thing.
  const u = parse(raw);
  if (u && isDriveHost(u.hostname) && /^\/(uc|thumbnail)$/.test(u.pathname)) return raw;
  const id = parseDriveFileId(raw);
  if (!id) return raw;
  return original ? driveOriginalUrl(id) : driveImageUrl(id);
}

// Drive reports the actual cause in error.errors[0].reason; the top-level
// message is usually the useless "Forbidden". Each of these is a different
// thing for the operator to go fix, so they get different sentences.
function listingError(status, body) {
  const reason = body?.error?.errors?.[0]?.reason || "";
  const detail = body?.error?.message || "";
  if (reason === "accessNotConfigured") {
    return bad("the Drive API isn't enabled on that Google Cloud project — enable it, then try again", 400);
  }
  if (reason === "keyInvalid" || status === 401) {
    return bad("that Google API key was rejected — check it in Settings", 400);
  }
  if (status === 403) {
    return bad(
      "the key is fine but Drive refused the folder — either the key is restricted to other APIs, or the folder isn't shared. Set the folder to \"Anyone with the link\"",
      403
    );
  }
  if (status === 404) {
    return bad("that folder doesn't exist, or it isn't shared — set it to \"Anyone with the link\"", 404);
  }
  return bad(`Drive returned ${status}${detail ? ` — ${detail}` : ""}`, 502);
}

/**
 * Every image in a shared Drive folder, in the order the operator sees them.
 * Returns { files: [{id, name, mimeType}], skipped, truncated }.
 *
 * Sorted by name_natural, not name, because photo filenames are numbered:
 * plain lexical order puts IMG_10 before IMG_2, and photo order is the whole
 * interface here — the first one becomes the deal's cover.
 *
 * Subfolders are not descended into. A folder of folders is a different
 * intent (a whole portfolio) and silently flattening it would be a surprise.
 */
export async function listDriveFolderImages(folderId, apiKey, { max = DRIVE_MAX_FILES, timeoutMs = 15000 } = {}) {
  if (!DRIVE_ID.test(String(folderId || ""))) throw bad("that isn't a Google Drive folder link");
  if (!String(apiKey || "").trim()) throw bad("Google API key not configured — add it in Settings");

  const files = [];
  let skipped = 0;
  let pageToken = "";
  let truncated = false;

  // Pages are 100 at a time; the loop stops as soon as we have `max` keepers.
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType)",
      orderBy: "name_natural",
      pageSize: "100",
      // Harmless for a My Drive folder, and the difference between working
      // and not for one that lives on a shared drive.
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      key: apiKey,
    });
    if (pageToken) qs.set("pageToken", pageToken);

    let res;
    try {
      res = await fetch(`${DRIVE_API_BASE}/files?${qs}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw bad(e.name === "TimeoutError" ? "Drive took too long to answer" : `couldn't reach Drive (${e.message})`, 502);
    }

    const body = await res.json().catch(() => null);
    if (!res.ok) throw listingError(res.status, body);

    for (const f of body?.files || []) {
      if (!f?.id || !DRIVE_ID.test(f.id)) continue;
      const type = String(f.mimeType || "");
      // EVERY image type is fair game, including the image/heic an iPhone
      // writes, because the download goes through Drive's /thumbnail and comes
      // back as JPEG — see the header. Non-images (a subfolder, the PSA PDF
      // filed alongside the photos) are counted so the operator can reconcile
      // "32 things in that folder" with "30 photos imported".
      if (!type.startsWith("image/")) { skipped++; continue; }
      if (files.length >= max) { truncated = true; break; }
      files.push({ id: f.id, name: String(f.name || "").slice(0, 200), mimeType: type });
    }

    pageToken = body?.nextPageToken || "";
    if (truncated || !pageToken) break;
  }

  // Empty-handed is always an error, but for different reasons worth telling
  // apart: an empty folder vs. one holding documents and no photos.
  if (!files.length) {
    throw bad(skipped ? `that folder has ${skipped} item(s) in it, but none of them are photos` : "that folder has no photos in it");
  }
  return { files, skipped, truncated };
}
