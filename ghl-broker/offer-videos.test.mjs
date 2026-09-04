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
// Tiny parts, so a 6KB fixture spans several objects and the range arithmetic
// that stitches them is what's under test. Must be set before video.js loads.
process.env.VIDEO_PART_BYTES = "4096";

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
// Enough of an MP4 to pass the sniffer — a 24-byte ftyp box — then bytes that
// are all different, so a slice from the wrong offset can't pass by accident.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from(Array.from({ length: 6000 }, (_, i) => (i * 7 + 3) & 0xff))]);
const partsOf = (buf) => { const out = []; for (let i = 0; i < buf.length; i += PART_BYTES) out.push(buf.subarray(i, Math.min(buf.length, i + PART_BYTES))); return out; };
const putPart = (vid, n, buf, loc = LOC) =>
  fetch(`${B}/api/offers/${offer.id}/videos/${vid}/parts/${n}?location_id=${loc}`, {
    method: "PUT", headers: { "content-type": "application/octet-stream" }, body: buf,
  });
const localDir = (vid) => path.join(videoLocalRoot, "videos", LOC, offer.id, vid);
const localPart = (vid, n) => path.join(localDir(vid), String(n).padStart(6, "0"));

async function uploadWhole() {
  const begun = await json("POST", `/api/offers/${offer.id}/videos`, {
    location_id: LOC, name: "walk.mp4", contentType: "video/mp4", sizeBytes: MP4.length,
  });
  assert.equal(begun.status, 200, JSON.stringify(begun.body));
  const vid = begun.body.video.id;
  const parts = [];
  for (const [i, chunk] of partsOf(MP4).entries()) {
    const r = await putPart(vid, i + 1, chunk);
    assert.equal(r.status, 200);
    parts.push({ n: i + 1, etag: (await r.json()).etag });
  }
  const done = await json("POST", `/api/offers/${offer.id}/videos/${vid}/complete`, {
    location_id: LOC, parts, width: 1920, height: 1080, durationS: 61.5,
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
  p = await putPart(vid, 1, MP4.subarray(0, PART_BYTES), OTHER);
  assert.equal(p.status, 404, "another location can't feed parts into this upload");
  p = await putPart(vid, 1, MP4);
  assert.equal(p.status, 413, "a part bigger than the agreed size is refused");
  const chunks = partsOf(MP4);
  assert.equal(chunks.length, 2, "the fixture spans two parts");
  const parts = [];
  for (const [i, chunk] of chunks.entries()) {
    p = await putPart(vid, i + 1, chunk);
    assert.equal(p.status, 200);
    const { etag } = await p.json();
    assert.ok(etag);
    parts.push({ n: i + 1, etag });
  }
  assert.ok(fs.existsSync(localPart(vid, 1)) && fs.existsSync(localPart(vid, 2)), "each part is an object of its own");

  let c = await json("POST", `/api/offers/${offer.id}/videos/${vid}/complete`, { location_id: LOC, parts });
  assert.equal(c.status, 400, "no poster, no video");
  c = await json("POST", `/api/offers/${offer.id}/videos/${vid}/complete`, { location_id: LOC, parts: [parts[1]], poster: { full: PIX, thumb: PIX } });
  assert.equal(c.status, 400, "a gap in the parts is refused");
  c = await json("POST", `/api/offers/${offer.id}/videos/${vid}/complete`, {
    location_id: LOC, parts, width: 1920, height: 1080, durationS: 61.5, poster: { full: PIX, thumb: PIX },
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.video.status, "ready");
  assert.equal(c.body.video.sizeBytes, MP4.length, "the size is measured from the object, not declared");
  assert.equal(c.body.video.width, 1920);
  assert.equal(c.body.video.durationS, 61.5);
  assert.equal(c.body.video.uploadId, null);

  assert.equal((await putPart(vid, 3, MP4.subarray(0, 100))).status, 404, "a finished upload takes no more parts");

  const streamUrl = `${B}/api/offers/${offer.id}/videos/${vid}/stream?location_id=${LOC}`;
  const slice = async (range) => {
    const r = await fetch(streamUrl, { headers: range ? { range } : {} });
    return { status: r.status, cr: r.headers.get("content-range"), len: r.headers.get("content-length"), bytes: Buffer.from(await r.arrayBuffer()) };
  };
  let s = await slice("bytes=4-7");
  assert.equal(s.status, 206);
  assert.equal(s.cr, `bytes 4-7/${MP4.length}`);
  assert.equal(s.bytes.toString("ascii"), "ftyp");
  // The seams are where stitching goes wrong: a slice across the boundary, a
  // slice that starts exactly on it, and one that ends one byte before it.
  s = await slice(`bytes=${PART_BYTES - 10}-${PART_BYTES + 9}`);
  assert.equal(s.status, 206);
  assert.equal(s.len, "20");
  assert.ok(s.bytes.equals(MP4.subarray(PART_BYTES - 10, PART_BYTES + 10)), "a slice across the part seam is byte-exact");
  s = await slice(`bytes=${PART_BYTES}-`);
  assert.ok(s.bytes.equals(MP4.subarray(PART_BYTES)), "a slice starting on the seam is the whole second part");
  s = await slice(`bytes=0-${PART_BYTES - 1}`);
  assert.ok(s.bytes.equals(MP4.subarray(0, PART_BYTES)), "a slice ending before the seam never touches part two");
  s = await slice("bytes=-4");
  assert.equal(s.status, 206, "a suffix range works");
  assert.ok(s.bytes.equals(MP4.subarray(MP4.length - 4)));
  s = await slice(null);
  assert.equal(s.status, 200);
  assert.ok(s.bytes.equals(MP4), "the whole file comes back byte-exact across both parts");
  const head = await fetch(streamUrl, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(MP4.length));
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal((await slice("bytes=999999-")).status, 416);

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
  assert.equal((await slice(null)).status, 404);
  assert.equal(fs.existsSync(localDir(vid)), false, "every part object is gone too");
});

test("parts that aren't the agreed size are refused and removed", async () => {
  const begun = await json("POST", `/api/offers/${offer.id}/videos`, { location_id: LOC, name: "short.mp4", contentType: "video/mp4", sizeBytes: MP4.length });
  const vid = begun.body.video.id;
  // A short FIRST part would shift every byte after it; the server can't know
  // at PUT time which part is last, so complete is where it has to catch it.
  const p1 = await putPart(vid, 1, MP4.subarray(0, PART_BYTES - 5));
  const p2 = await putPart(vid, 2, MP4.subarray(PART_BYTES - 5, PART_BYTES + 100));
  const parts = [{ n: 1, etag: (await p1.json()).etag }, { n: 2, etag: (await p2.json()).etag }];
  const c = await json("POST", `/api/offers/${offer.id}/videos/${vid}/complete`, { location_id: LOC, parts, poster: { full: PIX, thumb: PIX } });
  assert.equal(c.status, 400, JSON.stringify(c.body));
  assert.match(c.body.error, /agreed size/);
  assert.equal(fs.existsSync(localDir(vid)), false, "the bad parts don't linger");
  await json("DELETE", `/api/offers/${offer.id}/videos/${vid}?location_id=${LOC}`);
});

test("deleting an unfinished upload clears its parts", async () => {
  const begun = await json("POST", `/api/offers/${offer.id}/videos`, { location_id: LOC, name: "half.mp4", contentType: "video/mp4", sizeBytes: MP4.length });
  const vid = begun.body.video.id;
  assert.equal((await putPart(vid, 1, MP4.subarray(0, PART_BYTES))).status, 200);
  assert.ok(fs.existsSync(localPart(vid, 1)));
  const d = await json("DELETE", `/api/offers/${offer.id}/videos/${vid}?location_id=${LOC}`);
  assert.equal(d.status, 200);
  assert.equal(fs.existsSync(localDir(vid)), false, "no orphaned parts");
});

test("deleting the offer removes its video bytes", async () => {
  const v = await uploadWhole();
  assert.ok(fs.existsSync(localPart(v.id, 1)) && fs.existsSync(localPart(v.id, 2)));
  const d = await json("DELETE", `/api/offers/${offer.id}?location_id=${LOC}`);
  assert.equal(d.status, 200);
  assert.equal(fs.existsSync(localDir(v.id)), false);
  assert.equal((await store.listOfferVideos(offer.id)).length, 0);
});

test.after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});
