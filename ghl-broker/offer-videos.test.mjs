// offer-videos.test.mjs — the operator's video path: begin, parts, complete,
// stream, delete. Runs against the JSON backend and the local-disk object
// store, so it proves the routes and the bookkeeping; R2 itself is the same
// calls with a bucket behind them (r2.js).
//
// Run with:  npm run test:videos

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offer-videos-test-"));

const { default: express } = await import("express");
const { store } = await import("./store.js");
const { default: createOffersRouter } = await import("./routes/offers.js");
const { PART_BYTES, VIDEO_STORAGE_HINT, videoLocalRoot, videoStorageReady } = await import("./video.js");

const LOC = "loc-video-test";
const OTHER = "loc-someone-else";

const app = express();
app.use(express.json({ limit: "30mb" }));
app.use("/api/offers", createOffersRouter({
  resolveLocation: (req) => ({
    locationId: req.query.location_id || req.body?.location_id || LOC,
    client: { call: async () => ({}) },
  }),
  uploadDir: process.env.DATA_DIR,
  publicBaseUrl: "http://127.0.0.1:4995",
}));
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
await store.init();

const offer = await store.createOffer({ locationId: LOC, address: "1 Test St", contactId: "c1", cashAmount: 100000 });

const json = async (method, p, body) => {
  const r = await fetch(B + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const PIX = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAj/2Q==";
// Enough of an MP4 to pass the sniffer: a 24-byte ftyp box, then padding.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(6000, 1)]);
const putPart = (vid, n, buf, loc = LOC) =>
  fetch(`${B}/api/offers/${offer.id}/videos/${vid}/parts/${n}?location_id=${loc}`, {
    method: "PUT", headers: { "content-type": "application/octet-stream" }, body: buf,
  });
const localFile = (vid) => path.join(videoLocalRoot, "videos", LOC, offer.id, `${vid}.mp4`);

async function uploadWhole() {
  const begun = await json("POST", `/api/offers/${offer.id}/videos`, {
    location_id: LOC, name: "walk.mp4", contentType: "video/mp4", sizeBytes: MP4.length,
  });
  assert.equal(begun.status, 200, JSON.stringify(begun.body));
  const vid = begun.body.video.id;
  const { etag } = await (await putPart(vid, 1, MP4)).json();
  const done = await json("POST", `/api/offers/${offer.id}/videos/${vid}/complete`, {
    location_id: LOC, parts: [{ n: 1, etag }], width: 1920, height: 1080, durationS: 61.5,
    poster: { full: PIX, thumb: PIX },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body.video;
}

test("the storage hint names what to set, and only that", () => {
  // No bucket in the test environment, so every connection variable is missing
  // and the message has to say so — and must not ask for the documents
  // hostname, which video doesn't need.
  assert.ok(videoStorageReady, "the JSON backend falls back to local disk");
  for (const k of ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"]) assert.ok(VIDEO_STORAGE_HINT.includes(k), k);
  assert.ok(!VIDEO_STORAGE_HINT.includes("R2_PUBLIC_BASE"));
});

test("begin refuses what it can't store", async () => {
  let r = await json("POST", `/api/offers/${offer.id}/videos`, { location_id: LOC, name: "x.avi", contentType: "video/x-msvideo", sizeBytes: 10 });
  assert.equal(r.status, 400);
  r = await json("POST", `/api/offers/${offer.id}/videos`, { location_id: LOC, name: "x.mp4", contentType: "video/mp4", sizeBytes: 600 * 1024 * 1024 });
  assert.equal(r.status, 413);
  r = await json("POST", `/api/offers/${offer.id}/videos`, { location_id: LOC, name: "x.mp4", contentType: "video/mp4" });
  assert.equal(r.status, 400);
  r = await json("POST", `/api/offers/${offer.id}/videos`, { location_id: OTHER, name: "x.mp4", contentType: "video/mp4", sizeBytes: 10 });
  assert.equal(r.status, 404, "another location can't start an upload on this offer");
  assert.equal((await store.listOfferVideos(offer.id)).length, 0);
});

test("a video goes up in parts and comes back in slices", async () => {
  const begun = await json("POST", `/api/offers/${offer.id}/videos`, {
    location_id: LOC, name: "walk.mp4", contentType: "video/mp4", sizeBytes: MP4.length,
  });
  assert.equal(begun.status, 200, JSON.stringify(begun.body));
  assert.equal(begun.body.video.status, "uploading");
  assert.equal(begun.body.partBytes, PART_BYTES);
  const vid = begun.body.video.id;

  let list = (await json("GET", `/api/offers/${offer.id}/videos?location_id=${LOC}`)).body.videos;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "uploading");

  let p = await putPart(vid, 1, Buffer.from("this is not a video at all, honestly, not even close"));
  assert.equal(p.status, 400, "the first part has to carry a video header");
  p = await putPart(vid, 0, MP4);
  assert.equal(p.status, 400, "parts are numbered from one");
  p = await putPart(vid, 1, MP4, OTHER);
  assert.equal(p.status, 404, "another location can't feed parts into this upload");
  p = await putPart(vid, 1, MP4);
  assert.equal(p.status, 200);
  const { etag } = await p.json();
  assert.ok(etag);

  let c = await json("POST", `/api/offers/${offer.id}/videos/${vid}/complete`, { location_id: LOC, parts: [{ n: 1, etag }] });
  assert.equal(c.status, 400, "no poster, no video");
  c = await json("POST", `/api/offers/${offer.id}/videos/${vid}/complete`, { location_id: LOC, parts: [{ n: 2, etag }], poster: { full: PIX, thumb: PIX } });
  assert.equal(c.status, 400, "a gap in the parts is refused");
  c = await json("POST", `/api/offers/${offer.id}/videos/${vid}/complete`, {
    location_id: LOC, parts: [{ n: 1, etag }], width: 1920, height: 1080, durationS: 61.5, poster: { full: PIX, thumb: PIX },
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.video.status, "ready");
  assert.equal(c.body.video.sizeBytes, MP4.length, "the size is measured from the object, not declared");
  assert.equal(c.body.video.width, 1920);
  assert.equal(c.body.video.durationS, 61.5);
  assert.equal(c.body.video.uploadId, null);
  assert.ok(fs.existsSync(localFile(vid)), "bytes landed in the object store");

  assert.equal((await putPart(vid, 2, MP4)).status, 404, "a finished upload takes no more parts");

  let s = await fetch(`${B}/api/offers/${offer.id}/videos/${vid}/stream?location_id=${LOC}`, { headers: { range: "bytes=4-7" } });
  assert.equal(s.status, 206);
  assert.equal(s.headers.get("content-range"), `bytes 4-7/${MP4.length}`);
  assert.equal(s.headers.get("accept-ranges"), "bytes");
  assert.equal(Buffer.from(await s.arrayBuffer()).toString("ascii"), "ftyp");
  s = await fetch(`${B}/api/offers/${offer.id}/videos/${vid}/stream?location_id=${LOC}`, { headers: { range: "bytes=-4" } });
  assert.equal(s.status, 206, "a suffix range works");
  assert.equal((await s.arrayBuffer()).byteLength, 4);
  s = await fetch(`${B}/api/offers/${offer.id}/videos/${vid}/stream?location_id=${LOC}`);
  assert.equal(s.status, 200);
  assert.equal(s.headers.get("content-type"), "video/mp4");
  assert.equal((await s.arrayBuffer()).byteLength, MP4.length);
  s = await fetch(`${B}/api/offers/${offer.id}/videos/${vid}/stream?location_id=${LOC}`, { headers: { range: "bytes=999999-" } });
  assert.equal(s.status, 416);

  const po = await fetch(`${B}/api/offers/${offer.id}/videos/${vid}/poster/thumb?location_id=${LOC}`);
  assert.equal(po.status, 200);
  assert.equal(po.headers.get("content-type"), "image/jpeg");

  const o = await fetch(`${B}/api/offers/${offer.id}/videos/${vid}/stream?location_id=${OTHER}`);
  assert.equal(o.status, 404, "another location can't stream it");
  const ol = await json("GET", `/api/offers/${offer.id}/videos?location_id=${OTHER}`);
  assert.equal(ol.status, 404, "or list it");

  const d = await json("DELETE", `/api/offers/${offer.id}/videos/${vid}?location_id=${LOC}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.videos.length, 0);
  s = await fetch(`${B}/api/offers/${offer.id}/videos/${vid}/stream?location_id=${LOC}`);
  assert.equal(s.status, 404);
  assert.equal(fs.existsSync(localFile(vid)), false, "the bytes are gone too");
});

test("deleting an unfinished upload clears its parts", async () => {
  const begun = await json("POST", `/api/offers/${offer.id}/videos`, { location_id: LOC, name: "half.mp4", contentType: "video/mp4", sizeBytes: MP4.length });
  const vid = begun.body.video.id;
  assert.equal((await putPart(vid, 1, MP4)).status, 200);
  const d = await json("DELETE", `/api/offers/${offer.id}/videos/${vid}?location_id=${LOC}`);
  assert.equal(d.status, 200);
  assert.equal(fs.readdirSync(path.join(videoLocalRoot, ".multipart")).length, 0, "no orphaned parts");
});

test("deleting the offer removes its video bytes", async () => {
  const v = await uploadWhole();
  assert.ok(fs.existsSync(localFile(v.id)));
  const d = await json("DELETE", `/api/offers/${offer.id}?location_id=${LOC}`);
  assert.equal(d.status, 200);
  assert.equal(fs.existsSync(localFile(v.id)), false);
  assert.equal((await store.listOfferVideos(offer.id)).length, 0);
});

test.after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});
