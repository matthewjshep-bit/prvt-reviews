// drive-folder.test.mjs — the Drive folder importer.
//
// Two properties this file exists to protect:
//
//   1. The link parsers are a security boundary, not a convenience. They decide
//      whether a URL gets treated as "a folder of ours" and whether an id is
//      safe to interpolate into the Drive API's `q` expression.
//   2. The API key is a server-side secret. It goes out to Google and must
//      never come back in anything handed to the browser.
//
// The listing runs against a local stand-in for Drive (DRIVE_API_BASE_URL),
// so this exercises the real pagination, filtering and error mapping without
// spending anyone's quota.

import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

const FOLDER = "1tj7aCwk7fatRv8BMrdqc52JVUnqQdfX4";
const KEY = "AIzaTESTKEY";

// A fake Drive. `reply` decides what each request gets, and every request is
// recorded so a test can assert on what we actually asked Google for.
const calls = [];
let reply = () => ({ status: 200, body: { files: [] } });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  calls.push(Object.fromEntries(url.searchParams));
  const { status, body } = reply(url.searchParams);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
});
// Port 0: the OS picks a free one, because the suite runs test files in parallel.
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.DRIVE_API_BASE_URL = `http://127.0.0.1:${server.address().port}/drive/v3`;

const {
  parseDriveFolderId, parseDriveFileId, driveDirectUrl, driveImageUrl, listDriveFolderImages,
} = await import("./drive-folder.js");

test.after(() => server.close());
const img = (id, name, mimeType = "image/jpeg") => ({ id, name, mimeType });

/* ---------- what counts as a folder link ---------- */

test("every shape of Drive folder link Google hands out yields the same id", () => {
  for (const u of [
    `https://drive.google.com/drive/folders/${FOLDER}`,
    `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`,
    `https://drive.google.com/drive/u/0/folders/${FOLDER}`,
    `https://drive.google.com/drive/u/2/mobile/folders/${FOLDER}`,
    `  https://drive.google.com/drive/folders/${FOLDER}#anchor  `,
  ]) {
    assert.equal(parseDriveFolderId(u), FOLDER, u);
  }
});

test("a link that isn't a Drive folder is refused, including the lookalikes", () => {
  for (const u of [
    `https://drive.google.com/file/d/${FOLDER}/view`,   // a file, not a folder
    `https://photos.google.com/share/abc/folders/${FOLDER}`,
    `https://evil.example.com/drive/folders/${FOLDER}`, // path shape, wrong host
    `https://drive.google.com.evil.example/drive/folders/${FOLDER}`,
    "https://drive.google.com/drive/folders/short",     // id too short to be real
    "not a url at all",
    "",
    null,
  ]) {
    assert.equal(parseDriveFolderId(u), "", String(u));
  }
});

test("a folder id can never carry a quote out of the URL and into the API query", () => {
  // The id is interpolated into `'<id>' in parents`. Anything that could close
  // that quote has to fail the parse, not get escaped later.
  assert.equal(parseDriveFolderId("https://drive.google.com/drive/folders/abc'%20or%20'1"), "");
  assert.equal(parseDriveFolderId(`https://drive.google.com/drive/folders/${"a".repeat(20)}'`), "");
});

/* ---------- single-file links ---------- */

test("a file share link becomes a URL that answers with bytes, not a web page", () => {
  const view = `https://drive.google.com/file/d/${FOLDER}/view?usp=drive_link`;
  assert.equal(parseDriveFileId(view), FOLDER);
  assert.match(driveDirectUrl(view), /^https:\/\/drive\.google\.com\/thumbnail\?id=/);
  // An exhibit wants the real file — a "thumbnail" of a PDF is page one as a JPEG.
  assert.match(driveDirectUrl(view, { original: true }), /\/uc\?export=download&id=/);
});

test("anything that isn't a Drive file link passes through untouched", () => {
  for (const u of [
    "https://example.com/photo.jpg",
    "https://lh3.googleusercontent.com/d/abc=w2048",
    // Already direct — rewriting would second-guess an operator who pasted
    // the thing that works.
    `https://drive.google.com/uc?export=download&id=${FOLDER}`,
    `https://drive.google.com/thumbnail?id=${FOLDER}&sz=w2400`,
  ]) {
    assert.equal(driveDirectUrl(u), u, u);
  }
});

/* ---------- listing a folder ---------- */

test("the listing asks Drive for this folder only, in the order a human sees it", async () => {
  calls.length = 0;
  reply = () => ({ status: 200, body: { files: [img("aaaaaaaaaaaa", "IMG_2.jpg"), img("bbbbbbbbbbbb", "IMG_10.jpg")] } });
  const { files } = await listDriveFolderImages(FOLDER, KEY);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].q, `'${FOLDER}' in parents and trashed = false`);
  assert.equal(calls[0].key, KEY);
  // name_natural, not name: photo filenames are numbered, and plain lexical
  // order puts IMG_10 before IMG_2. Photo order is the interface — the first
  // one becomes the deal's cover.
  assert.equal(calls[0].orderBy, "name_natural");
  assert.deepEqual(files.map((f) => f.name), ["IMG_2.jpg", "IMG_10.jpg"]);
});

test("the API key goes to Google and never comes back toward the browser", async () => {
  reply = () => ({ status: 200, body: { files: [img("aaaaaaaaaaaa", "a.jpg")] } });
  const { files } = await listDriveFolderImages(FOLDER, KEY);
  // What the route hands the client is driveImageUrl() of each id.
  const clientUrl = driveImageUrl(files[0].id);
  assert.ok(!clientUrl.includes(KEY), "download URL must not carry the key");
  assert.ok(!JSON.stringify(files).includes(KEY), "listing must not echo the key");
});

test("an iPhone HEIC is kept — the download re-encodes it — and non-photos are counted, not lost", async () => {
  reply = () => ({
    status: 200,
    body: {
      files: [
        img("aaaaaaaaaaaa", "kitchen.jpg"),
        img("bbbbbbbbbbbb", "roof.heic", "image/heic"),
        img("cccccccccccc", "PSA.pdf", "application/pdf"),
        img("dddddddddddd", "Before", "application/vnd.google-apps.folder"),
      ],
    },
  });
  const { files, skipped } = await listDriveFolderImages(FOLDER, KEY);
  assert.deepEqual(files.map((f) => f.name), ["kitchen.jpg", "roof.heic"]);
  // The PDF and the subfolder: reported so "4 things in the folder, 2 photos
  // imported" reconciles instead of looking like a bug.
  assert.equal(skipped, 2);
});

test("pagination keeps going until Drive stops handing back a token", async () => {
  calls.length = 0;
  reply = (p) => p.get("pageToken")
    ? { status: 200, body: { files: [img("bbbbbbbbbbbb", "b.jpg")] } }
    : { status: 200, body: { nextPageToken: "page2", files: [img("aaaaaaaaaaaa", "a.jpg")] } };
  const { files } = await listDriveFolderImages(FOLDER, KEY);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].pageToken, "page2");
  assert.deepEqual(files.map((f) => f.name), ["a.jpg", "b.jpg"]);
});

test("a folder bigger than the cap stops at the cap and says so", async () => {
  reply = () => ({
    status: 200,
    // Always another page: without the cap this would loop until the page limit.
    body: { nextPageToken: "more", files: Array.from({ length: 100 }, (_, i) => img(`aaaaaaaaaaa${i}`, `p${i}.jpg`)) },
  });
  const { files, truncated } = await listDriveFolderImages(FOLDER, KEY, { max: 5 });
  assert.equal(files.length, 5);
  assert.equal(truncated, true);
});

/* ---------- when it doesn't work ---------- */

test("each way Drive can say no becomes its own thing to go fix", async () => {
  const cases = [
    [403, { error: { errors: [{ reason: "accessNotConfigured" }] } }, /Drive API isn't enabled/],
    [400, { error: { errors: [{ reason: "keyInvalid" }] } }, /key was rejected/],
    [403, { error: { errors: [{ reason: "forbidden" }] } }, /Anyone with the link/],
    [404, { error: { errors: [{ reason: "notFound" }] } }, /isn't shared/],
    [500, { error: { message: "backend error" } }, /Drive returned 500/],
  ];
  for (const [status, body, expected] of cases) {
    reply = () => ({ status, body });
    await assert.rejects(() => listDriveFolderImages(FOLDER, KEY), expected, `${status} ${JSON.stringify(body)}`);
  }
});

test("an empty folder and a folder of documents fail differently", async () => {
  reply = () => ({ status: 200, body: { files: [] } });
  await assert.rejects(() => listDriveFolderImages(FOLDER, KEY), /no photos in it/);

  reply = () => ({ status: 200, body: { files: [img("cccccccccccc", "PSA.pdf", "application/pdf")] } });
  await assert.rejects(() => listDriveFolderImages(FOLDER, KEY), /none of them are photos/);
});

test("a missing key never reaches the network", async () => {
  calls.length = 0;
  await assert.rejects(() => listDriveFolderImages(FOLDER, "  "), /not configured/);
  await assert.rejects(() => listDriveFolderImages("nope", KEY), /isn't a Google Drive folder link/);
  assert.equal(calls.length, 0);
});
